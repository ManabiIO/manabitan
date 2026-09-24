/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {expect, test} from 'vitest'
import {
    MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS,
    prepareTermLookupIndexesFromPreinternedPlan,
} from '../ext/js/dictionary/term-lookup-index-preparation.js'

class SliceForbiddenUint8Array extends Uint8Array {
    slice() {
        throw new Error('segmented lookup flags must not be copied')
    }
}

class SliceForbiddenInt32Array extends Int32Array {
    slice() {
        throw new Error('segmented lookup sequences must not be copied')
    }
}

test('segmented lookup preparation borrows typed row columns', () => {
    const rowCount = MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS + 1
    const flagsBacking = new ArrayBuffer(rowCount + 8)
    const readingEqualsExpressionList = new SliceForbiddenUint8Array(flagsBacking, 4, rowCount)
    readingEqualsExpressionList.fill(1)

    const sequenceBacking = new ArrayBuffer((rowCount + 4) * Int32Array.BYTES_PER_ELEMENT)
    const sequenceList = new SliceForbiddenInt32Array(
        sequenceBacking,
        2 * Int32Array.BYTES_PER_ELEMENT,
        rowCount,
    )
    sequenceList.fill(-1)
    sequenceList[rowCount - 1] = 42

    const expressionIndexes = new Uint32Array(rowCount)
    expressionIndexes[rowCount - 1] = 1
    const readingIndexes = Uint32Array.from(expressionIndexes)

    const prepared = prepareTermLookupIndexesFromPreinternedPlan({
        rowCount,
        readingEqualsExpressionList,
        sequenceList,
        termRecordPreinternedPlan: {
            stringLengths: Uint16Array.of(1, 1, 0),
            stringOffsets: Uint32Array.of(0, 1, 2),
            stringsBuffer: Uint8Array.of(0x61, 0x62),
            expressionIndexes,
            readingIndexes,
        },
    })

    expect(prepared?.indexes.size).toBe(2)
    expect(prepared?.indexes.has(`0:${MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS}`)).toBe(true)
    expect(prepared?.indexes.has(`${MAX_PREPARED_TERM_LOOKUP_INDEX_ROWS}:1`)).toBe(true)
    expect(readingEqualsExpressionList.byteOffset).toBe(4)
    expect(sequenceList.byteOffset).toBe(2 * Int32Array.BYTES_PER_ELEMENT)
    expect(sequenceList[rowCount - 1]).toBe(42)
})
