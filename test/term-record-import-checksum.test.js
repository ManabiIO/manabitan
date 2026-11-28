/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'
import {encodePersistedTermLookupIndex, hashTermLookupKeyBytes} from '../ext/js/dictionary/term-lookup-index.js'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

const createChecksum = vi.hoisted(() => vi.fn())
vi.mock('../ext/js/dictionary/term-record-checksum.js', () => ({createImportLookupChecksum: createChecksum}))

beforeEach(() => { createChecksum.mockReset().mockResolvedValue(null) })
afterEach(() => { vi.restoreAllMocks() })

function checksumFixture() {
    return {
        hash: vi.fn((/** @type {Uint8Array} */ bytes) => /** @type {number|null} */ (hashTermLookupKeyBytes(bytes))),
        dispose: vi.fn(),
    }
}

function chunkFixture() {
    const store = new TermRecordOpfsStore()
    const payload = encodePersistedTermLookupIndex([
        {expressionBytes: new TextEncoder().encode('日本語'), readingBytes: null, sequence: 3},
    ])
    const fields = new Uint8Array(12)
    new DataView(fields.buffer).setUint32(4, 8, true)
    const encode = () => store._createLookupIndexChunk(1, 1, 0, payload, fields)
    return {store, payload, fields, encode}
}

function pendingChecksum() {
    /** @type {(checksum: ReturnType<typeof checksumFixture>|null) => void} */
    let resolve = () => { throw new Error('Promise not initialized') }
    const promise = new Promise((settle) => { resolve = settle })
    return {promise, resolve}
}

describe('import-owned checksum initialization', () => {
    test('normal preparation and lookups do not load the optional module', async () => {
        const {store, encode} = chunkFixture()
        await store.prepare()
        encode()
        expect(createChecksum).not.toHaveBeenCalled()
    })

    test('pending initialization does not block begin or early chunks', async () => {
        const pending = pendingChecksum()
        createChecksum.mockReturnValue(pending.promise)
        const {store, encode} = chunkFixture()
        const expected = encode()
        await store.beginImportSession()
        await store.beginImportSession()
        expect(encode()).toEqual(expected)
        expect(createChecksum).toHaveBeenCalledTimes(1)
        const checksum = checksumFixture()
        pending.resolve(checksum)
        await pending.promise
        expect(encode()).toEqual(expected)
        expect(checksum.hash).toHaveBeenCalledTimes(3)
        await store.endImportSession()
        expect(checksum.dispose).toHaveBeenCalledTimes(1)
        expect(store.getLastEndImportSessionMetrics()?.lookupChecksum).toMatchObject({nativeCalls: 3, javascriptCalls: 3})
        expect(store.getLastEndImportSessionMetrics()?.lookupChecksum.nativeBytes).toBeGreaterThan(0)
    })

    test.each(['end', 'rollback', 'reset'])('discards late initialization after %s', async (operation) => {
        const pending = pendingChecksum()
        createChecksum.mockReturnValue(pending.promise)
        const {store} = chunkFixture()
        await store.beginImportSession()
        if (operation === 'end') { await store.endImportSession() }
        if (operation === 'rollback') { await store._abandonImportWritesForRollback() }
        if (operation === 'reset') { await store.reset() }
        const old = checksumFixture()
        pending.resolve(old)
        await pending.promise
        expect(old.dispose).toHaveBeenCalledTimes(1)
        expect(Reflect.get(store, '_importLookupChecksumSession')).toBeNull()
    })

    test('preparation cannot discard an active import instance', async () => {
        const checksum = checksumFixture()
        createChecksum.mockResolvedValue(checksum)
        const {store, encode} = chunkFixture()
        await store.beginImportSession()
        await expect(store.prepare()).rejects.toThrow('Cannot mutate term-record storage during an active import session')
        encode()
        expect(checksum.hash).toHaveBeenCalledTimes(3)
        expect(checksum.dispose).not.toHaveBeenCalled()
        await store.endImportSession()
    })

    test('an old completion cannot replace a later import instance', async () => {
        const pending = pendingChecksum()
        createChecksum.mockReturnValueOnce(pending.promise)
        const {store, encode} = chunkFixture()
        await store.beginImportSession()
        await store._abandonImportWritesForRollback()
        const current = checksumFixture()
        createChecksum.mockResolvedValueOnce(current)
        await store.beginImportSession()
        const old = checksumFixture()
        pending.resolve(old)
        await pending.promise
        encode()
        expect(old.dispose).toHaveBeenCalledTimes(1)
        expect(old.hash).not.toHaveBeenCalled()
        expect(current.hash).toHaveBeenCalledTimes(3)
        await store.endImportSession()
    })

    test('retains the instance through final flush and disposes it even if flushing fails', async () => {
        const checksum = checksumFixture()
        createChecksum.mockResolvedValue(checksum)
        const {store, encode} = chunkFixture()
        await store.beginImportSession()
        vi.spyOn(store, '_flushPendingWrites').mockImplementationOnce(async () => {
            encode()
            expect(checksum.dispose).not.toHaveBeenCalled()
            throw new Error('Write failed')
        })
        await expect(store.endImportSession()).rejects.toThrow('Write failed')
        expect(checksum.hash).toHaveBeenCalledTimes(3)
        expect(checksum.dispose).toHaveBeenCalledTimes(1)
        expect(Reflect.get(store, '_importLookupChecksumSession')).toBeNull()
    })

    test('handles initialization rejection without failing or delaying the import', async () => {
        createChecksum.mockRejectedValue(new Error('Optional initialization failed'))
        const {store, encode} = chunkFixture()
        const expected = encode()
        await store.beginImportSession()
        expect(encode()).toEqual(expected)
        await store.endImportSession()
    })
})

describe('write-side checksum semantics', () => {
    test('hashes the current bytes again after mutation and uses JavaScript for a declined section', async () => {
        const checksum = checksumFixture()
        createChecksum.mockResolvedValue(checksum)
        const {store, fields, encode} = chunkFixture()
        const original = encode()
        await store.beginImportSession()
        expect(encode()).toEqual(original)
        fields[8] = 13
        checksum.hash.mockReturnValueOnce(null)
        const changed = encode()
        expect(changed).not.toEqual(original)
        await store.endImportSession()
        expect(encode()).toEqual(changed)
    })

    test('accepts a valid zero hash without substituting the JavaScript result', async () => {
        const checksum = checksumFixture()
        checksum.hash.mockReturnValue(0)
        createChecksum.mockResolvedValue(checksum)
        const {store, encode} = chunkFixture()
        await store.beginImportSession()
        const bytes = encode()
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        expect([24, 28, 32].map((offset) => view.getUint32(offset, true))).toEqual([0, 0, 0])
        await store.endImportSession()
    })
})
