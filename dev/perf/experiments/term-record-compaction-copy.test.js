/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {describe, expect, test, vi} from 'vitest'
import {compactTermRecordPreinternedPlan} from '../ext/js/dictionary/term-record-preinterned-plan.js'

/** @typedef {import('../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} Plan */

/**
 * @param {number[]} lengths
 * @param {number[][]} rows
 * @param {boolean} shared
 * @returns {Plan}
 */
function createPlan(lengths, rows, shared) {
    const size = lengths.reduce((sum, length) => sum + length, 0)
    const backing = shared ? new SharedArrayBuffer(size + 31) : new ArrayBuffer(size + 31)
    const arena = new Uint8Array(backing, 13, size)
    for (let i = 0; i < size; i++) { arena[i] = (i * 31 + (i >>> 8)) & 255 }
    const offsets = new Uint32Array(lengths.length)
    let cursor = 0
    for (let i = 0; i < lengths.length; i++) {
        offsets[i] = cursor
        cursor += lengths[i]
    }
    return {
        stringLengths: Uint16Array.from(lengths),
        stringOffsets: offsets,
        stringHashes: Uint32Array.from(lengths, (_, i) => Math.imul(i + 1, 0x9e3779b9) >>> 0),
        stringsBuffer: arena,
        expressionIndexes: Uint32Array.from(rows, (row) => row[0]),
        readingIndexes: Uint32Array.from(rows, (row) => row[1]),
    }
}

/**
 * Independent first-use remapping and byte-by-byte copying oracle.
 * @param {Plan} plan
 * @param {number} start
 * @param {number} count
 * @param {boolean[]|Uint8Array|undefined} equalReadings
 * @returns {Plan}
 */
function referenceCompact(plan, start, count, equalReadings = void 0) {
    /** @type {Map<number, number>} */
    const indexes = new Map()
    /** @type {number[]} */
    const oldIndexes = []
    /**
     * @param {number} oldIndex
     * @returns {number}
     */
    const intern = (oldIndex) => {
        const existing = indexes.get(oldIndex)
        if (typeof existing === 'number') { return existing }
        const result = oldIndexes.length
        indexes.set(oldIndex, result)
        oldIndexes.push(oldIndex)
        return result
    }
    const expressions = []
    const readings = []
    for (let i = start; i < start + count; i++) {
        expressions.push(intern(plan.expressionIndexes[i]))
        const equal = equalReadings?.[i] === true || equalReadings?.[i] === 1
        readings.push(intern(equal ? plan.expressionIndexes[i] : plan.readingIndexes[i]))
    }
    const sourceOffsets = []
    let sourceOffset = 0
    for (const length of plan.stringLengths) {
        sourceOffsets.push(sourceOffset)
        sourceOffset += length
    }
    const offsets = []
    const bytes = []
    for (const oldIndex of oldIndexes) {
        offsets.push(bytes.length)
        for (let i = 0; i < plan.stringLengths[oldIndex]; i++) {
            bytes.push(plan.stringsBuffer[sourceOffsets[oldIndex] + i])
        }
    }
    const hashes = plan.stringHashes
    return {
        stringLengths: Uint16Array.from(oldIndexes, (i) => plan.stringLengths[i]),
        stringOffsets: Uint32Array.from(offsets),
        stringHashes: typeof hashes === 'undefined' ? void 0 : Uint32Array.from(oldIndexes, (i) => hashes[i]),
        stringsBuffer: Uint8Array.from(bytes),
        expressionIndexes: Uint32Array.from(expressions),
        readingIndexes: Uint32Array.from(readings),
    }
}

/**
 * @param {Plan} plan
 * @param {number} start
 * @param {number} count
 * @param {boolean[]|Uint8Array|undefined} equalReadings
 */
function verify(plan, start, count, equalReadings = void 0) {
    const scratch = new Uint32Array(plan.stringLengths.length)
    const snapshot = new Uint8Array(plan.stringsBuffer)
    const expected = referenceCompact(plan, start, count, equalReadings)
    const actual = compactTermRecordPreinternedPlan(plan, start, count, scratch, equalReadings)
    expect(actual).toStrictEqual(expected)
    expect(scratch.every((value) => value === 0)).toBe(true)
    expect(plan.stringsBuffer.every((value, index) => value === snapshot[index])).toBe(true)
    expect(actual?.stringsBuffer.buffer).not.toBe(plan.stringsBuffer.buffer)
    plan.stringsBuffer.fill(255)
    expect(actual?.stringsBuffer).toStrictEqual(expected.stringsBuffer)
}

describe('preinterned string compaction copy runs', () => {
    test.each([false, true])('copies an adjacent nonzero-start run once; shared=%s', (shared) => {
        const plan = createPlan([2, 3, 1, 4, 2, 5, 1, 9], [[0, 1], [2, 3], [4, 5], [6, 6]], shared)
        const spy = vi.spyOn(plan.stringsBuffer, 'subarray')
        try {
            verify(plan, 1, 3)
            expect(spy).toHaveBeenCalledTimes(1)
            expect(spy).toHaveBeenCalledWith(5, 18)
        } finally {
            spy.mockRestore()
        }
    })

    test.each([false, true])('preserves reordered runs and excludes gaps; shared=%s', (shared) => {
        const plan = createPlan(Array.from({length: 10}, () => 2), [[3, 4], [1, 2], [6, 7], [7, 8]], shared)
        const spy = vi.spyOn(plan.stringsBuffer, 'subarray')
        try {
            verify(plan, 0, 4)
            expect(spy.mock.calls).toStrictEqual([[6, 10], [2, 6], [12, 18]])
        } finally {
            spy.mockRestore()
        }
    })

    test.each([false, true])('preserves zero-length keys at reordered seams; shared=%s', (shared) => {
        verify(createPlan([0, 2, 0, 1, 0, 2, 0], [[4, 0], [5, 2], [1, 3], [6, 6]], shared), 0, 4)
    })

    test.each([false, true])('supports an all-empty arena without source copies; shared=%s', (shared) => {
        const plan = createPlan([0, 0, 0, 0], [[2, 0], [3, 1]], shared)
        const spy = vi.spyOn(plan.stringsBuffer, 'subarray')
        try {
            verify(plan, 0, 2)
            expect(spy).not.toHaveBeenCalled()
        } finally {
            spy.mockRestore()
        }
    })

    test.each([false, true])('handles maximal Uint16 lengths and omitted metadata; shared=%s', (shared) => {
        const plan = createPlan([65535, 0, 65535, 1], [[2, 3], [0, 1]], shared)
        delete plan.stringOffsets
        delete plan.stringHashes
        verify(plan, 0, 2)
    })

    test.each([false, true])('returns an owned empty row slice; shared=%s', (shared) => {
        verify(createPlan([0, 3, 1], [[1, 2]], shared), 1, 0)
    })

    test.each([false, true])('matches an independent oracle over 500 deterministic plans; shared=%s', (shared) => {
        let seed = 0x6090821
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed >>> 8
        }
        for (let caseIndex = 0; caseIndex < 500; caseIndex++) {
            const keys = 1 + random() % 64
            const rowCount = 1 + random() % 64
            const lengths = Array.from({length: keys}, () => random() % 17)
            const rows = Array.from({length: rowCount}, () => [random() % keys, random() % keys])
            const plan = createPlan(lengths, rows, shared)
            const equality = Uint8Array.from({length: rowCount}, () => Number(random() % 3 === 0))
            for (let i = 0; i < rowCount; i++) {
                if (equality[i] === 1) { plan.readingIndexes[i] = 0xffffffff }
            }
            if (caseIndex % 2 === 0) { delete plan.stringOffsets }
            if (caseIndex % 3 === 0) { delete plan.stringHashes }
            const start = random() % (rowCount + 1)
            const count = random() % (rowCount - start + 1)
            verify(plan, start, count, caseIndex % 2 === 0 ? equality : Array.from(equality, Boolean))
        }
    })
})
