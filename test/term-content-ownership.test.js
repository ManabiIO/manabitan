/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {
    registerOwnedTermContent,
    shouldBorrowProjectedTermContent,
    shouldOwnTermContentBytes,
    takeOwnedTermContent,
} from '../ext/js/dictionary/term-content-ownership.js'

describe('compact parser content ownership', () => {
    test('admits complete cacheable groups within the smallest cache budget', () => {
        expect(shouldOwnTermContentBytes(512, 1, 1, 1)).toBe(true)
        expect(shouldOwnTermContentBytes(48 * 1024 * 1024, 48 * 2048, 48 * 2048, 48 * 2048)).toBe(true)
    })

    test.each([
        [undefined, 1, 1, 1],
        [0, 1, 1, 1],
        [1.5, 1, 1, 1],
        [Number.NaN, 1, 1, 1],
        [513, 1, 1, 1],
        [48 * 1024 * 1024 + 1, 100_000, 100_000, 100_000],
        [4, undefined, 1, 1],
        [4, 0, 1, 1],
        [4, 1.5, 2, 2],
        [4, 2, 1, 1],
        [4, 1, 2, 1],
        [4, 1, undefined, 1],
        [4, 1, Infinity, Infinity],
    ])('keeps borrowed transport for noncacheable or incomplete groups (%s, %s, %s, %s)', (bytes, unique, sourceRows, rows) => {
        expect(shouldOwnTermContentBytes(bytes, unique, sourceRows, /** @type {number} */ (rows))).toBe(false)
    })

    test('requires an actual registered transfer and consumes its witness once', () => {
        const source = Uint8Array.of(1, 2, 3, 4)
        expect(takeOwnedTermContent(source)).toBe(false)
        Reflect.set(source, 'ownsContentBytes', true)
        expect(takeOwnedTermContent(source)).toBe(false)
        const transferred = structuredClone(source, {transfer: [source.buffer]})
        expect(source.byteLength).toBe(0)
        registerOwnedTermContent(transferred)
        expect(takeOwnedTermContent(transferred)).toBe(true)
        expect(takeOwnedTermContent(transferred)).toBe(false)
    })

    test('never registers empty or partial backing buffers', () => {
        for (const source of [new Uint8Array(0), new Uint8Array(8).subarray(1, 5), new Uint8Array(new SharedArrayBuffer(8)).subarray(1, 5)]) {
            registerOwnedTermContent(source)
            expect(takeOwnedTermContent(source)).toBe(false)
        }
    })

    test('shared memory requires the private producer witness before adoption', () => {
        const source = new Uint8Array(new SharedArrayBuffer(8))
        expect(takeOwnedTermContent(source)).toBe(false)
        expect(registerOwnedTermContent(source)).toBe(true)
        expect(takeOwnedTermContent(source)).toBe(true)
        expect(takeOwnedTermContent(source)).toBe(false)
    })
})

describe('large projected content borrowing', () => {
    test('requires more than the compact-content byte limit per term row', () => {
        expect(shouldBorrowProjectedTermContent(512, 1, 1, 1)).toBe(false)
        expect(shouldBorrowProjectedTermContent(513, 1, 1, 1)).toBe(true)
        expect(shouldBorrowProjectedTermContent(1024, 2, 2, 2)).toBe(false)
        expect(shouldBorrowProjectedTermContent(1025, 2, 2, 2)).toBe(true)
    })

    test('keeps private lookahead when many rows reuse a small content slab', () => {
        expect(shouldBorrowProjectedTermContent(600, 1, 40_000, 40_000)).toBe(false)
        expect(shouldBorrowProjectedTermContent(600 * 1000, 1000, 40_000, 40_000)).toBe(false)
        expect(shouldBorrowProjectedTermContent(18 * 1024 * 1024, 16_000, 20_000, 20_000)).toBe(true)
    })

    test('never displaces cacheable compact ownership', () => {
        for (const [bytes, unique, rows] of [[512, 1, 1], [512, 1, 20], [48 * 1024 * 1024, 100_000, 100_000]]) {
            expect(shouldOwnTermContentBytes(bytes, unique, rows, rows)).toBe(true)
            expect(shouldBorrowProjectedTermContent(bytes, unique, rows, rows)).toBe(false)
        }
    })

    test.each([
        [undefined, 1, 1, 1],
        [0, 1, 1, 1],
        [1024.5, 1, 1, 1],
        [Number.NaN, 1, 1, 1],
        [Infinity, 1, 1, 1],
        [Number.MAX_SAFE_INTEGER + 1, 1, 1, 1],
        [1024, undefined, 1, 1],
        [1024, 0, 1, 1],
        [1024, 1.5, 1, 1],
        [1024, 2, 1, 1],
        [1024, 1, 2, 1],
        [1024, 1, undefined, 1],
        [1024, 1, 0, 0],
        [1024, 1, Infinity, Infinity],
    ])('rejects incomplete or invalid groups (%s, %s, %s, %s)', (bytes, unique, sourceRows, rows) => {
        expect(shouldBorrowProjectedTermContent(bytes, unique, sourceRows, /** @type {number} */ (rows))).toBe(false)
    })
})
