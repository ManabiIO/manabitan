/*
 * Copyright (C) 2026  Yomitan Authors
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

/**
 * Plans disjoint scratch allocations inside retired parser regions. This does
 * not write bytes or change the WASM allocator. The caller must ensure every
 * region is dead before using these addresses, and keep the source memory alive.
 * @param {Array<{pointer: number, byteLength: number}>} regions
 * @param {number} memoryBytes
 * @returns {{allocate: (size: number) => number|null, usedBytes: () => number}}
 * @throws {RangeError} If regions overlap or address/size arithmetic is invalid.
 */
export function createRetiredLookupScratchAllocator(regions, memoryBytes) {
    if (!Number.isSafeInteger(memoryBytes) || memoryBytes < 0) { throw new RangeError('Invalid parser memory size') }
    const arenas = regions.map(({pointer, byteLength}) => {
        if (!Number.isSafeInteger(pointer) || pointer <= 0 || pointer % 8 !== 0 ||
        !Number.isSafeInteger(byteLength) || byteLength < 0 || pointer > memoryBytes ||
        byteLength > memoryBytes - pointer) { throw new RangeError('Invalid retired parser region') }
        return {pointer, byteLength, cursor: 0}
    }).sort((a, b) => a.pointer - b.pointer)
    for (let i = 1; i < arenas.length; ++i) {
        if (arenas[i].pointer < arenas[i - 1].pointer + arenas[i - 1].byteLength) {
            throw new RangeError('Retired parser regions overlap')
        }
    }
    let used = 0
    return {
        allocate(size) {
            if (!Number.isSafeInteger(size) || size <= 0 || size > memoryBytes) { throw new RangeError('Invalid scratch size') }
            const aligned = Math.ceil(size / 8) * 8
            let best = -1
            let available = Infinity
            for (let i = 0; i < arenas.length; ++i) {
                const remaining = arenas[i].byteLength - arenas[i].cursor
                if (remaining >= aligned && remaining < available) {
                    best = i
                    available = remaining
                }
            }
            if (best < 0) { return null }
            const arena = arenas[best]
            const pointer = arena.pointer + arena.cursor
            arena.cursor += aligned
            used += aligned
            return pointer
        },
        usedBytes() { return used },
    }
}
