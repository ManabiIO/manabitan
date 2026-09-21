/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

/** @typedef {import('../../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} Plan */

/**
 * Construct an arena without using the production builder or compactor.
 * @param {Uint8Array[]} keys
 * @param {number[]} expression
 * @param {number[]} [reading]
 * @param {{offsets?: boolean, hashes?: boolean, padding?: number, shared?: boolean}} [options]
 * @returns {Plan}
 */
export function makeCopyFixture(keys, expression, reading = expression, options = {}) {
    const stringLengths = Uint16Array.from(keys, (key) => key.length)
    const stringOffsets = new Uint32Array(keys.length)
    let total = 0
    for (let i = 0; i < keys.length; ++i) {
        stringOffsets[i] = total
        total += keys[i].length
    }
    const padding = options.padding ?? 0
    const backing = options.shared ? new SharedArrayBuffer(total + 2 * padding) : new ArrayBuffer(total + 2 * padding)
    const slab = new Uint8Array(backing).fill(0xa5)
    const stringsBuffer = new Uint8Array(backing, padding, total)
    for (let i = 0; i < keys.length; ++i) { stringsBuffer.set(keys[i], stringOffsets[i]) }
    return {
        stringLengths,
        stringOffsets: options.offsets === false ? void 0 : stringOffsets,
        stringHashes: options.hashes === false ? void 0 : Uint32Array.from(keys, (_, i) => i % 4 === 0 ? 0 : Math.imul(i + 1, 2654435761) >>> 0),
        stringsBuffer,
        expressionIndexes: Uint32Array.from(expression),
        readingIndexes: Uint32Array.from(reading),
    }
}

/**
 * Model first-use key identity using source keys, not arena span arithmetic.
 * @param {Uint8Array[]} keys
 * @param {Plan} plan
 * @param {number} start
 * @param {number} count
 * @param {boolean[]|Uint8Array} [equal]
 * @returns {Plan}
 */
export function expectedCopyPlan(keys, plan, start, count, equal) {
    /** @type {Map<number, number>} */
    const positions = new Map()
    const expressions = []
    const readings = []
    /** @param {number} id @returns {number} */
    const intern = (id) => {
        let position = positions.get(id)
        if (typeof position === 'undefined') {
            position = positions.size
            positions.set(id, position)
        }
        return position
    }
    for (let row = start; row < start + count; ++row) {
        const expression = plan.expressionIndexes[row]
        const reading = equal?.[row] === true || equal?.[row] === 1 ? expression : plan.readingIndexes[row]
        expressions.push(intern(expression))
        readings.push(intern(reading))
    }
    const sourceIds = [...positions.keys()]
    const selected = sourceIds.map((id) => keys[id])
    const bytes = selected.flatMap((key) => [...key])
    const offsets = []
    let offset = 0
    for (const key of selected) {
        offsets.push(offset)
        offset += key.length
    }
    const sourceHashes = plan.stringHashes
    return {
        stringLengths: Uint16Array.from(selected, (key) => key.length),
        stringOffsets: Uint32Array.from(offsets),
        stringHashes: sourceHashes === void 0 ? void 0 : Uint32Array.from(sourceIds, (id) => sourceHashes[id]),
        stringsBuffer: Uint8Array.from(bytes),
        expressionIndexes: Uint32Array.from(expressions),
        readingIndexes: Uint32Array.from(readings),
    }
}
