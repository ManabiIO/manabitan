/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'

/** @typedef {import('dictionary-database').DatabaseTermEntry} Row */
/** @typedef {{offset: number, length: number, dictName: string}} ContentMeta */

/**
 * The production staging loop runs unchanged. Storage and cache boundaries are
 * deterministic so every submitted row, span and transaction can be inspected.
 * @param {{asyncHits?: boolean, localTransaction?: boolean, failInsert?: boolean, termBatchSize?: number}} [options]
 * @returns {{database: DictionaryDatabase, run: (rows: Row[], start?: number, count?: number) => Promise<void>, stagedSizes: number[], submitted: {row: Row, offset: number, length: number, dictName: string|null}[], appended: Uint8Array[], lookup: ReturnType<typeof vi.fn>, exec: ReturnType<typeof vi.fn>, insertError: Error}}
 */
function createFixture(options = {}) {
    const database = new DictionaryDatabase()
    const exec = vi.fn()
    Reflect.set(database, '_db', {exec})
    Reflect.set(database, '_termContentZstdInitialized', true)
    Reflect.set(database, '_bulkImportTransactionOpen', !options.localTransaction)
    Reflect.set(database, '_termBulkAddStagingMaxRows', 512)
    Reflect.set(database, '_getTermBulkAddBatchSizeForCount', () => options.termBatchSize ?? 512)
    /** @type {Map<number, ContentMeta>} */
    const cache = new Map([[1, {offset: 71, length: 1, dictName: 'raw'}]])
    const lookup = vi.fn((/** @type {number} */ hash1) => {
        const meta = cache.get(hash1)
        return options.asyncHits ? Promise.resolve(meta) : meta
    })
    Reflect.set(database, '_findMatchingTermEntryContentMeta', lookup)
    Reflect.set(database, '_ensureTermEntryContentMetaHashPairCapacity', () => {})
    Reflect.set(database, '_cacheTermEntryContentMeta', (
        /** @type {string|null} */ _hash,
        /** @type {number} */ offset,
        /** @type {number} */ length,
        /** @type {string} */ dictName,
        /** @type {number} */ _id,
        /** @type {number} */ hash1,
    ) => { cache.set(hash1, {offset, length, dictName}) })
    /** @type {Uint8Array[]} */
    const appended = []
    let cursor = 1000
    Reflect.set(database, '_termContentStore', {
        appendBatch: async (/** @type {Uint8Array[]} */ chunks) => chunks.map((bytes) => {
            const offset = cursor
            cursor += bytes.length
            appended.push(Uint8Array.from(bytes))
            return {offset, length: bytes.length}
        }),
    })
    Reflect.set(database, '_createTermContentStorageChunks', (/** @type {Uint8Array[]} */ bytes) => ({
        storedChunks: bytes,
        entryToStoredChunkIndexes: bytes.map((_, i) => i),
        entryToStoredChunkOffsets: bytes.map(() => 0),
        contentDictNames: bytes.map(() => 'raw'),
    }))
    /** @type {number[]} */
    const stagedSizes = []
    /** @type {{row: Row, offset: number, length: number, dictName: string|null}[]} */
    const submitted = []
    const insertError = new Error('injected insert failure')
    Reflect.set(database, '_insertResolvedImportTermEntries', async (
        /** @type {Row[]} */ rows,
        /** @type {number[]} */ offsets,
        /** @type {number[]} */ lengths,
        /** @type {(string|null)[]} */ dictNames,
        /** @type {number} */ start,
        /** @type {number} */ count,
    ) => {
        stagedSizes.push(rows.length)
        if (options.failInsert) { throw insertError }
        for (let i = start; i < start + count; ++i) {
            submitted.push({row: rows[i], offset: offsets[i], length: lengths[i], dictName: dictNames[i]})
        }
        return {termRecordAppendMs: 0, termsVtabInsertMs: 0}
    })
    return {
        database,
        stagedSizes,
        submitted,
        appended,
        lookup,
        exec,
        insertError,
        run: async (rows, start = 0, count = rows.length - start) => {
            await Reflect.get(database, '_bulkAddTerms').call(database, rows, start, count)
        },
    }
}

/**
 * @param {number} index
 * @param {number} [hash=1]
 * @returns {Row}
 */
function createRow(index, hash = 1) {
    return {
        dictionary: 'Cached staging fixture',
        expression: `term${index}`,
        reading: '',
        definitionTags: '',
        termTags: '',
        rules: '',
        glossary: [],
        score: 0,
        sequence: -1,
        termEntryContentBytes: Uint8Array.of(hash & 0xff),
        termEntryContentHash1: hash,
        termEntryContentHash2: 17,
    }
}

describe('cached term import staging bound', () => {
    test.each([false, true])('bounds all-cache-hit batches with async hits=%s', async (asyncHits) => {
        const fixture = createFixture({asyncHits})
        const rows = Array.from({length: 1537}, (_, i) => createRow(i))
        await fixture.run(rows)
        expect(fixture.stagedSizes).toEqual([512, 512, 512, 1])
        expect(fixture.submitted.map(({row}) => row)).toEqual(rows)
        expect(fixture.submitted.every(({offset, length, dictName}) => offset === 71 && length === 1 && dictName === 'raw')).toBe(true)
        expect(fixture.appended).toHaveLength(0)
    })

    test('honors staging capacity independently of a larger SQL batch size', async () => {
        const fixture = createFixture({termBatchSize: 2048})
        await fixture.run(Array.from({length: 1025}, (_, i) => createRow(i)))
        expect(fixture.stagedSizes).toEqual([512, 512, 1])
        expect(fixture.submitted).toHaveLength(1025)
    })

    test('a cache hit flushes pending new content at the boundary and later rows reuse it', async () => {
        const fixture = createFixture()
        const rows = Array.from({length: 1025}, (_, i) => createRow(i, i === 0 || i === 512 ? 2 : 1))
        await fixture.run(rows)
        expect(fixture.stagedSizes).toEqual([512, 512, 1])
        expect(fixture.submitted.map(({row}) => row)).toEqual(rows)
        expect(fixture.appended).toEqual([Uint8Array.of(2)])
        expect(fixture.submitted[0].offset).toBe(1000)
        expect(fixture.submitted[512].offset).toBe(1000)
        expect(fixture.submitted.filter(({offset}) => offset === 71)).toHaveLength(1023)
    })

    test('retains uncached row batching, order and byte-distinct content', async () => {
        const fixture = createFixture()
        const rows = Array.from({length: 1025}, (_, i) => createRow(i, i + 2))
        await fixture.run(rows)
        expect(fixture.stagedSizes).toEqual([512, 512, 1])
        expect(fixture.submitted.map(({row}) => row)).toEqual(rows)
        expect(fixture.appended).toEqual(rows.map((row) => row.termEntryContentBytes))
        expect(fixture.submitted.map(({offset}) => offset)).toEqual(rows.map((_, i) => 1000 + i))
    })

    test('processes only the requested nonzero range', async () => {
        const fixture = createFixture()
        const rows = Array.from({length: 1200}, (_, i) => createRow(i))
        await fixture.run(rows, 51, 1025)
        expect(fixture.stagedSizes).toEqual([512, 512, 1])
        expect(fixture.submitted.map(({row}) => row)).toEqual(rows.slice(51, 1076))
        expect(fixture.lookup).toHaveBeenCalledTimes(1025)
    })

    test.each([true, false])('stops on a cached-batch failure with local transaction=%s', async (localTransaction) => {
        const fixture = createFixture({localTransaction, failInsert: true})
        await expect(fixture.run(Array.from({length: 1025}, (_, i) => createRow(i)))).rejects.toBe(fixture.insertError)
        expect(fixture.lookup).toHaveBeenCalledTimes(512)
        expect(fixture.stagedSizes).toEqual([512])
        expect(fixture.exec.mock.calls.map(([sql]) => sql)).toEqual(localTransaction ? ['BEGIN IMMEDIATE', 'ROLLBACK'] : [])
    })

    test('commits only once after the final local-transaction batch', async () => {
        const fixture = createFixture({localTransaction: true})
        await fixture.run(Array.from({length: 1025}, (_, i) => createRow(i)))
        expect(fixture.stagedSizes).toEqual([512, 512, 1])
        expect(fixture.exec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN IMMEDIATE', 'COMMIT'])
    })

    test('retains empty and partial input behavior', async () => {
        const fixture = createFixture()
        await fixture.run([])
        expect(fixture.stagedSizes).toHaveLength(0)
        await fixture.run(Array.from({length: 17}, (_, i) => createRow(i)))
        expect(fixture.stagedSizes).toEqual([17])
        expect(fixture.appended).toHaveLength(0)
    })
})
