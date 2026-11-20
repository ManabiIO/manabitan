/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test} from 'vitest'
import {
    registerOwnedTermContent,
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
