/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {hashPairToHex} from '../ext/js/dictionary/term-entry-content-hash.js'

/**
 * @param {number[]} bytes
 * @returns {import('dictionary-database').DatabaseTermEntry}
 */
function row(bytes) {
    const hash1 = 0x12345678
    const hash2 = 0x9abcdef0
    return /** @type {import('dictionary-database').DatabaseTermEntry} */ ({
        dictionary: 'collision-test',
        expression: 'x',
        reading: 'x',
        definitionTags: '',
        rules: '',
        score: 0,
        glossary: [],
        termTags: '',
        termEntryContentBytes: Uint8Array.from(bytes),
        termEntryContentHash: hashPairToHex(hash1, hash2),
        termEntryContentHash1: hash1,
        termEntryContentHash2: hash2,
    })
}

test('pending term content dedupe retains all byte-distinct candidates sharing one hash', async () => {
    const database = new DictionaryDatabase()
    Reflect.set(database, '_db', {})
    Reflect.set(database, '_bulkImportTransactionOpen', true)
    Reflect.set(database, '_termContentZstdInitialized', true)
    Reflect.set(database, '_findMatchingTermEntryContentMeta', vi.fn(() => void 0))
    Reflect.set(database, '_ensureTermEntryContentMetaHashPairCapacity', vi.fn())
    Reflect.set(database, '_cacheTermEntryContentMeta', vi.fn())

    /** @type {Uint8Array[][]} */
    const appended = []
    Reflect.set(database, '_termContentStore', {
        appendBatch: vi.fn(async (/** @type {Uint8Array[]} */ chunks) => {
            appended.push(chunks.map((chunk) => Uint8Array.from(chunk)))
            return chunks.map((chunk, index) => ({offset: 100 + index * 100, length: chunk.byteLength}))
        }),
    })
    Reflect.set(database, '_createTermContentStorageChunks', vi.fn((/** @type {Uint8Array[]} */ chunks) => ({
        storedChunks: chunks,
        entryToStoredChunkIndexes: Uint32Array.from(chunks, (_chunk, index) => index),
        entryToStoredChunkOffsets: new Uint32Array(chunks.length),
        contentDictNames: new Array(chunks.length).fill('raw'),
    })))

    /** @type {number[]} */
    const insertedOffsets = []
    Reflect.set(database, '_insertResolvedImportTermEntries', vi.fn(async (
        /** @type {import('dictionary-database').DatabaseTermEntry[]} */ _rows,
        /** @type {number[]} */ offsets,
        /** @type {number[]} */ _lengths,
        /** @type {(string|null)[]} */ _dictNames,
        /** @type {number} */ start,
        /** @type {number} */ count,
    ) => {
        insertedOffsets.push(...offsets.slice(start, start + count))
        return {termRecordAppendMs: 0, termRecordEncodeMs: 0, termRecordWriteMs: 0, termsVtabInsertMs: 0}
    }))

    const bulkAddTerms = Reflect.get(database, '_bulkAddTerms').bind(database)
    await bulkAddTerms([row([1]), row([2]), row([1]), row([2])], 0, 4)

    expect(appended).toHaveLength(1)
    expect(appended[0]).toEqual([Uint8Array.of(1), Uint8Array.of(2)])
    expect(insertedOffsets).toEqual([100, 200, 100, 200])
})

test('ordinary repeated hashes retain the single-index fast path behavior', async () => {
    const database = new DictionaryDatabase()
    Reflect.set(database, '_db', {})
    Reflect.set(database, '_bulkImportTransactionOpen', true)
    Reflect.set(database, '_termContentZstdInitialized', true)
    Reflect.set(database, '_findMatchingTermEntryContentMeta', vi.fn(() => void 0))
    Reflect.set(database, '_ensureTermEntryContentMetaHashPairCapacity', vi.fn())
    Reflect.set(database, '_cacheTermEntryContentMeta', vi.fn())
    const appendBatch = vi.fn(async (/** @type {Uint8Array[]} */ chunks) => chunks.map((chunk, index) => ({
        offset: 100 + index * 100,
        length: chunk.byteLength,
    })))
    Reflect.set(database, '_termContentStore', {appendBatch})
    Reflect.set(database, '_createTermContentStorageChunks', vi.fn((/** @type {Uint8Array[]} */ chunks) => ({
        storedChunks: chunks,
        entryToStoredChunkIndexes: Uint32Array.from(chunks, (_chunk, index) => index),
        entryToStoredChunkOffsets: new Uint32Array(chunks.length),
        contentDictNames: new Array(chunks.length).fill('raw'),
    })))
    Reflect.set(database, '_insertResolvedImportTermEntries', vi.fn(async () => ({
        termRecordAppendMs: 0, termRecordEncodeMs: 0, termRecordWriteMs: 0, termsVtabInsertMs: 0,
    })))

    const same = row([7, 8, 9])
    const bulkAddTerms = Reflect.get(database, '_bulkAddTerms').bind(database)
    await bulkAddTerms([same, row([7, 8, 9]), row([7, 8, 9])], 0, 3)

    expect(appendBatch).toHaveBeenCalledTimes(1)
    expect(appendBatch.mock.calls[0][0]).toEqual([Uint8Array.of(7, 8, 9)])
})
