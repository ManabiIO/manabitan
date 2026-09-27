/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {expect, test} from 'vitest'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

test('term-record queued-write failure rejects later queued chunks immediately', () => {
    const store = new TermRecordOpfsStore()
    const failure = new Error('simulated background write failure')
    const state = {
        queuedWriteError: failure,
        queuedWriteChunks: [],
        queuedWriteBytes: 0,
        queuedWritePromise: null,
        importWriteStarted: false,
    }
    const queue = /** @type {(state: any, chunks: Uint8Array[]) => void} */ (
        Reflect.get(store, '_queueWriteChunksForShard')
    ).bind(store)

    expect(() => queue(state, [Uint8Array.of(1, 2, 3)])).toThrow(failure)
    expect(state.queuedWriteChunks).toEqual([])
    expect(state.queuedWriteBytes).toBe(0)
    expect(state.queuedWritePromise).toBeNull()
    expect(state.importWriteStarted).toBe(false)
})

test('empty queue submission remains a no-op after a sticky write failure', () => {
    const store = new TermRecordOpfsStore()
    const state = {
        queuedWriteError: new Error('simulated background write failure'),
        queuedWriteChunks: [],
        queuedWriteBytes: 0,
        queuedWritePromise: null,
        importWriteStarted: false,
    }
    const queue = /** @type {(state: any, chunks: Uint8Array[]) => void} */ (
        Reflect.get(store, '_queueWriteChunksForShard')
    ).bind(store)

    expect(() => queue(state, [])).not.toThrow()
})


test.each([
    ['record data', 'queuedWriteError'],
    ['lookup index', 'lookupIndexWriteError'],
])('shard admission rejects sticky %s failures before append mutation', (_label, errorField) => {
    const store = new TermRecordOpfsStore()
    const failure = new Error(`simulated ${errorField} failure`)
    const getShardFileName = /** @type {(dictionary: string, contentDictName: string) => string} */ (
        Reflect.get(store, '_getShardFileName')
    ).bind(store)
    const logicalKey = getShardFileName('dictionary', 'raw')
    /** @type {Record<string, any>} */
    const state = {
        fileName: logicalKey,
        fileLength: 0,
        initialFileLength: 0,
        queuedWriteError: null,
        lookupIndexWriteError: null,
    }
    state[errorField] = failure
    Reflect.set(store, '_activeAppendShardStateByKey', new Map([[logicalKey, state]]))
    const assertAccepts = /** @type {(dictionary: string, contentDictName?: string) => void} */ (
        Reflect.get(store, '_assertShardAcceptsAppend')
    ).bind(store)

    expect(() => assertAccepts('dictionary', 'raw')).toThrow(failure)
})
