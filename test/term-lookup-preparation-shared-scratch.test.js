/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {expect, test} from 'vitest'
import {prepareTermLookupIndexesFromPreinternedPlan} from '../ext/js/dictionary/term-lookup-index-preparation.js'
import {findSequenceRows, parsePersistedTermLookupIndex} from '../ext/js/dictionary/term-lookup-index.js'
import {createTermRecordPreinternedPlanBuilder} from '../ext/js/dictionary/term-record-preinterned-plan.js'

test('cloned shared scratch preserves nonzero sequences and its original values', () => {
    const builder = createTermRecordPreinternedPlanBuilder(16)
    const encoder = new TextEncoder()
    for (const text of ['common', 'last', 'reading', 'last-reading']) { builder.internStringBytes(encoder.encode(text)) }
    const buffer = new SharedArrayBuffer(16)
    const sequenceList = new Int32Array(buffer)
    sequenceList.set([0, 42, 0, 43])
    const chunk = {
        rowCount: 4,
        readingEqualsExpressionList: new Uint8Array(4),
        sequenceList,
        termRecordPreinternedPlan: builder.buildPlan([0, 0, 0, 1], [2, 2, 2, 3]),
    }
    const scratch = new Uint32Array(structuredClone(buffer))
    expect(scratch.buffer).not.toBe(buffer)
    // structuredClone shares SharedArrayBuffer storage, so snapshot values.
    const before = {...structuredClone(chunk), sequenceList: Int32Array.from(sequenceList)}
    // Match dirty-scratch state: it can legitimately select compaction.
    const expected = prepareTermLookupIndexesFromPreinternedPlan(structuredClone(chunk), Uint32Array.from(scratch))
    const actual = prepareTermLookupIndexesFromPreinternedPlan(chunk, scratch)
    expect(actual?.indexes).toEqual(expected?.indexes)
    expect(chunk).toEqual(before)
    expect(scratch).toEqual(Uint32Array.of(0, 42, 0, 43))
    const index = parsePersistedTermLookupIndex(actual?.indexes.get('0:4')?.bytes ?? new Uint8Array())
    expect(findSequenceRows(index, 42)).toEqual([1])
    expect(findSequenceRows(index, 43)).toEqual([3])
})
