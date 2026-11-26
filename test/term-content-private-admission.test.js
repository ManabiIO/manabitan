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

import {describe, expect, test, vi} from 'vitest'
import {DictionaryDatabase} from '../ext/js/dictionary/dictionary-database.js'
import {TermContentBlockStore} from '../ext/js/dictionary/term-content-block-store.js'
import {TermContentOpfsStore} from '../ext/js/dictionary/term-content-opfs-store.js'
import {compressWrappedTermContentZstdBlocks} from '../ext/js/dictionary/zstd-term-content.js'

vi.mock('../ext/js/dictionary/zstd-term-content.js', async (importOriginal) => ({
    ...await importOriginal(),
    compressWrappedTermContentZstdBlocks: vi.fn(async (
        /** @type {Uint32Array} */ lengths,
        /** @type {(index: number) => Uint8Array} */ createBlock,
    ) => ({
        chunks: Array.from(lengths, (_, index) => createBlock(index)),
        envelopeMs: 0,
        wrapped: false,
    })),
    decompressTermContentZstd: (/** @type {Uint8Array} */ bytes) => new Uint8Array(bytes),
}))

/**
 * @param {string} dictionary
 * @returns {{database: DictionaryDatabase, blockStore: TermContentBlockStore, session: ReturnType<TermContentBlockStore['beginImportSession']>}}
 */
function createPersistence(dictionary) {
    const database = new DictionaryDatabase()
    const blockStore = new TermContentBlockStore(new TermContentOpfsStore(), {
        minInputBytes: 0,
        blockTargetBytes: 3,
        referencePackTargetBytes: 40,
    })
    const session = blockStore.beginImportSession()
    Reflect.get(session, '_blockEnabledDictionaries').add(dictionary)
    Reflect.set(database, '_termContentZstdInitialized', true)
    Reflect.set(database, '_termContentBlockImportSession', session)
    return {database, blockStore, session}
}

describe('private content persistence admission', () => {
    test.each(['JMdict', 'Jitendex.org [2026-10-03]', 'VNDB Characters by Bee'])(
        'preserves ordinary content bytes without attempting a reservation for %s',
        async (dictionary) => {
            const {database, blockStore, session} = createPersistence(dictionary)
            const reserve = vi.spyOn(session, 'tryBeginAppendSpans')
            const source = Uint8Array.of(1, 2, 3, 4, 5, 6)
            const spans = {buffer: source, offsets: Uint32Array.of(0, 3), lengths: Uint32Array.of(3, 3)}

            expect(database._tryBeginPersistArtifactTermContent(dictionary, spans)).toBeNull()
            expect(reserve).not.toHaveBeenCalled()
            const stored = await database._persistArtifactTermContent(dictionary, [], null, 'raw', spans)

            expect(stored.pendingLengths).toEqual(spans.lengths)
            expect(stored.blockProfile).not.toBeNull()
            for (let index = 0; index < spans.lengths.length; ++index) {
                expect(await blockStore.read(
                    stored.pendingOffsets[index],
                    stored.pendingLengths[index],
                    /** @type {string} */ (stored.pendingResolvedDictNames),
                )).toEqual(source.slice(index * 3, index * 3 + 3))
            }
        },
    )

    test('keeps shared JMdict content on the reservation route', () => {
        const {database, session} = createPersistence('JMdict')
        const reserve = vi.spyOn(session, 'tryBeginAppendSpans').mockReturnValue(null)
        const source = new Uint8Array(new SharedArrayBuffer(3))
        const spans = {buffer: source, offsets: Uint32Array.of(0), lengths: Uint32Array.of(3)}
        expect(database._tryBeginPersistArtifactTermContent('JMdict', spans)).toBeNull()
        expect(reserve).toHaveBeenCalledExactlyOnceWith('JMdict', source, spans.offsets, spans.lengths, 'jmdict')
    })

    test('leaves generic shared content on ordinary persistence', () => {
        const {database, session} = createPersistence('VNDB Characters by Bee')
        const reserve = vi.spyOn(session, 'tryBeginAppendSpans')
        const source = new Uint8Array(new SharedArrayBuffer(3))
        const spans = {buffer: source, offsets: Uint32Array.of(0), lengths: Uint32Array.of(3)}
        expect(database._tryBeginPersistArtifactTermContent('VNDB Characters by Bee', spans)).toBeNull()
        expect(reserve).not.toHaveBeenCalled()
    })

    test.each([
        {name: 'late out-of-bounds span', offsets: [0, 3], lengths: [3, 4], error: RangeError, shared: false},
        {name: 'mismatched columns', offsets: [0, 3], lengths: [3], error: TypeError, shared: false},
        {name: 'shared late out-of-bounds span', offsets: [0, 3], lengths: [3, 4], error: RangeError, shared: true},
        {name: 'shared mismatched columns', offsets: [0, 3], lengths: [3], error: TypeError, shared: true},
    ])('still rejects $name on ordinary persistence and the public reservation API', async ({offsets, lengths, error, shared}) => {
        const dictionary = 'Jitendex.org [2026-10-03]'
        const {database, blockStore} = createPersistence(dictionary)
        const compression = vi.mocked(compressWrappedTermContentZstdBlocks)
        compression.mockClear()
        const spans = {buffer: Uint8Array.of(1, 2, 3, 4, 5, 6), offsets: Uint32Array.from(offsets), lengths: Uint32Array.from(lengths)}
        if (shared) {
            spans.offsets = new Uint32Array(new SharedArrayBuffer(offsets.length * 4))
            spans.offsets.set(offsets)
            spans.lengths = new Uint32Array(new SharedArrayBuffer(lengths.length * 4))
            spans.lengths.set(lengths)
        }
        expect(database._tryBeginPersistArtifactTermContent(dictionary, spans)).toBeNull()
        await expect(database._persistArtifactTermContent(dictionary, [], null, 'raw', spans)).rejects.toThrow(error)
        expect(() => blockStore.tryBeginAppendSpans(spans.buffer, spans.offsets, spans.lengths, 'jmdict', true)).toThrow(error)
        expect(compression).not.toHaveBeenCalled()
    })

    test('rolls back reserved metadata before a rejected ordinary append can publish records', async () => {
        const dictionary = 'Jitendex.org [2026-10-03]'
        const {database} = createPersistence(dictionary)
        Reflect.set(database, '_bulkImportTransactionOpen', true)
        Reflect.set(database, '_deferTermsVirtualTableSync', true)
        /** @type {Parameters<DictionaryDatabase['_bulkAddArtifactTermsChunkWithContentDedup']>[0]} */
        const chunk = {
            dictionary,
            dictionaryTotalRows: 2,
            rowCount: 2,
            expressionBytesList: [Uint8Array.of(97), Uint8Array.of(98)],
            readingBytesList: [new Uint8Array(0), new Uint8Array(0)],
            readingEqualsExpressionList: Uint8Array.of(1, 1),
            scoreList: new Int32Array(2),
            sequenceList: Int32Array.of(-1, -1),
            contentBytesList: [],
            contentHash1List: new Uint32Array(0),
            contentHash2List: new Uint32Array(0),
            contentBytesBuffer: Uint8Array.of(1, 2, 3, 4, 5, 6),
            contentBytesBaseOffset: 0,
            contentMetaList: Uint32Array.of(0, 3, 10, 20, 3, 3, 11, 21),
            contentUniqueIndexList: Uint32Array.of(0, 1),
            contentDictNameList: null,
            uniformContentDictName: 'raw',
            contentDedupPlan: {
                uniqueCount: 2,
                sourceRowCount: 2,
                resolvedFlags: new Uint8Array(2),
                resolvedOffsets: new Float64Array(2),
                resolvedLengths: new Uint32Array(2),
                resolvedDictNames: null,
                pendingEpochs: new Uint32Array(2),
                pendingIndexes: new Uint32Array(2),
                nextEpoch: 1,
                nextUnresolvedUniqueIndex: 0,
                persistedLookupRequired: false,
            },
        }
        const resolve = database._resolveArtifactTermContentDedup.bind(database)
        vi.spyOn(database, '_resolveArtifactTermContentDedup').mockImplementation(async (...args) => {
            const result = await resolve(...args)
            expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(2)
            if (result.pendingContentSpans === null) { throw new Error('Expected pending spans') }
            result.pendingContentSpans.lengths[1] = 4
            return result
        })
        const rollback = vi.spyOn(database, '_rollbackStagedArtifactTermContentMetadata')
        const publishPlan = vi.spyOn(database, '_publishResolvedArtifactTermContentPlan')
        const publishMetadata = vi.spyOn(database, '_publishArtifactTermContentMetadata')
        const appendRecords = vi.spyOn(database, '_appendResolvedArtifactTermRecords')

        await expect(database._bulkAddArtifactTermsChunkWithContentDedup(chunk)).rejects.toThrow('out of bounds')

        expect(rollback).toHaveBeenCalledOnce()
        expect(publishPlan).not.toHaveBeenCalled()
        expect(publishMetadata).not.toHaveBeenCalled()
        expect(appendRecords).not.toHaveBeenCalled()
        expect(Reflect.get(database, '_termEntryContentMetaHashPairPendingCount')).toBe(0)
        expect(Reflect.get(database, '_termEntryContentMetaHashPairCount')).toBe(0)
        expect(chunk.contentDedupPlan?.resolvedFlags).toEqual(new Uint8Array(2))
    })
})
