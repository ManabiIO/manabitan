/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

const dictionary = 'Rejected fast append'
const encoder = new TextEncoder()

/**
 * @returns {TermRecordOpfsStore}
 */
function createRejectedStore() {
    const store = new TermRecordOpfsStore()
    Reflect.set(store, '_recordsDirectoryHandle', {})
    Reflect.set(store, '_nextIdMayNeedShardScan', false)
    const logicalKey = Reflect.get(store, '_getShardFileName').call(store, dictionary, 'raw')
    Reflect.get(store, '_activeAppendShardStateByKey').set(
        logicalKey,
        /** @type {any} */ ({
            fileName: logicalKey,
            fileLength: 64,
            initialFileLength: 64,
            queuedWriteError: null,
            lookupIndexWriteError: null,
        }),
    )
    return store
}

/**
 * @param {TermRecordOpfsStore} store
 * @param {() => Promise<unknown>} invoke
 */
async function expectRejectedWithoutMutation(store, invoke) {
    const nextId = Reflect.get(store, '_nextId')
    const size = store.size
    const loaded = new Set(Reflect.get(store, '_loadedDictionaryNames'))
    const dirty = Reflect.get(store, '_indexDirty')

    await expect(invoke()).rejects.toThrow(/finalized authoritative term records/u)

    expect(Reflect.get(store, '_nextId')).toBe(nextId)
    expect(store.size).toBe(size)
    expect(new Set(Reflect.get(store, '_loadedDictionaryNames'))).toEqual(loaded)
    expect(Reflect.get(store, '_indexDirty')).toBe(dirty)
}

describe('fast term-record append admission is mutation-free on rejection', () => {
    test('SQL term rows', async () => {
        const store = createRejectedStore()
        const row = [
            dictionary, 'term', 'reading', null, null, null,
            0, 4, 'raw', null, null, null, 1, null, 10,
        ]
        await expectRejectedWithoutMutation(
            store,
            async () => await store.appendBatchFromTermRows([row], 0, 1),
        )
    })

    test('resolved importer entries', async () => {
        const store = createRejectedStore()
        const rows = [{dictionary, expression: 'term', reading: 'reading', score: 1, sequence: 10}]
        await expectRejectedWithoutMutation(
            store,
            async () => await store.appendBatchFromResolvedImportTermEntries(
                rows, 0, 1, [0], [4], ['raw'],
            ),
        )
    })

    test('raw-span importer entries', async () => {
        const store = createRejectedStore()
        const rows = [{dictionary, expression: 'term', reading: 'reading', score: 1, sequence: 10}]
        await expectRejectedWithoutMutation(
            store,
            async () => await store.appendBatchFromImportTermEntries(
                rows, 0, 1, [{offset: 0, length: 4}],
            ),
        )
    })

    test('resolved-content importer entries', async () => {
        const store = createRejectedStore()
        const rows = [{dictionary, expression: 'term', reading: 'reading', score: 1, sequence: 10}]
        await expectRejectedWithoutMutation(
            store,
            async () => await store.appendBatchFromImportTermEntriesResolvedContent(
                rows, 0, 1, [0], [4], 'raw',
            ),
        )
    })

    test('artifact chunks', async () => {
        const store = createRejectedStore()
        await expectRejectedWithoutMutation(
            store,
            async () => await store.appendBatchFromArtifactChunkResolvedContent(
                {
                    dictionary,
                    rowCount: 1,
                    expressionBytesList: [encoder.encode('term')],
                    readingBytesList: [encoder.encode('reading')],
                    readingEqualsExpressionList: new Uint8Array([0]),
                    scoreList: new Int32Array([1]),
                    sequenceList: new Int32Array([10]),
                },
                [0],
                [4],
                'raw',
            ),
        )
    })
})
